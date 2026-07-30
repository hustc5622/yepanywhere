import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import {
  FilterDropdown,
  type FilterOption,
} from "../components/FilterDropdown";
import { FolderBrowserModal } from "../components/FolderBrowserModal";
import { PageHeader } from "../components/PageHeader";
import { ProjectCard } from "../components/ProjectCard";
import { ProjectListSkeleton } from "../components/Skeleton";
import { useInboxContext } from "../contexts/InboxContext";
import { useHideSplashOnReady } from "../hooks/useHideSplashOnReady";
import { useProjects } from "../hooks/useProjects";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";

type ProjectStatusFilter = "all" | "needsAttention" | "active";
type ProjectAgeFilter = "all" | "1" | "7" | "30";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function ProjectsPage() {
  const { t } = useI18n();
  const { projects, loading, error, refetch } = useProjects();
  const { needsAttention, active } = useInboxContext();

  // Dismiss the cold-start splash once the projects fetch resolves (or
  // errors). This is the default landing route, so for fresh installs the
  // splash will sit on top of the connection + fetch flow until cards
  // are actually ready to render.
  useHideSplashOnReady(!loading || error !== null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Filter / search state (local — survives within this mount, not URL)
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProjectStatusFilter[]>([]);
  const [ageFilter, setAgeFilter] = useState<ProjectAgeFilter[]>([]);
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();

  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  // Count needs-attention items per project (client-side filter - free)
  const attentionByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of needsAttention) {
      const current = counts.get(item.projectId) ?? 0;
      counts.set(item.projectId, current + 1);
    }
    return counts;
  }, [needsAttention]);

  // Count actively-thinking sessions per project (from inbox "active" tier)
  const thinkingByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of active) {
      const current = counts.get(item.projectId) ?? 0;
      counts.set(item.projectId, current + 1);
    }
    return counts;
  }, [active]);

  // Sort projects: those needing attention first, then by recency
  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      const aNeeds = attentionByProject.get(a.id) ?? 0;
      const bNeeds = attentionByProject.get(b.id) ?? 0;

      // Projects needing attention come first
      if (aNeeds > 0 && bNeeds === 0) return -1;
      if (bNeeds > 0 && aNeeds === 0) return 1;

      // Then sort by last activity (most recent first)
      const aTime = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const bTime = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return bTime - aTime;
    });
  }, [projects, attentionByProject]);

  // Apply search + filters on top of sorted projects
  const filteredProjects = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    const now = Date.now();
    return sortedProjects.filter((p) => {
      // Search by name or path
      if (q) {
        const hay = `${p.name ?? ""} ${p.path ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      // Status filter (multi-select OR semantics — match any)
      if (statusFilter.length > 0) {
        const ok = statusFilter.some((s) => {
          if (s === "all") return true;
          if (s === "needsAttention")
            return (attentionByProject.get(p.id) ?? 0) > 0;
          if (s === "active") return (thinkingByProject.get(p.id) ?? 0) > 0;
          return false;
        });
        if (!ok) return false;
      }
      // Age filter (most-recent of selected windows)
      if (ageFilter.length > 0 && !ageFilter.includes("all")) {
        const lastTs = p.lastActivity ? new Date(p.lastActivity).getTime() : 0;
        if (!lastTs) return false;
        const ageMs = now - lastTs;
        const maxDays = Math.max(...ageFilter.map((d) => Number.parseInt(d)));
        if (ageMs > maxDays * MS_PER_DAY) return false;
      }
      return true;
    });
  }, [
    sortedProjects,
    searchInput,
    statusFilter,
    ageFilter,
    attentionByProject,
    thinkingByProject,
  ]);

  const statusOptions: FilterOption<ProjectStatusFilter>[] = useMemo(
    () => [
      { value: "needsAttention", label: t("projectsFilterNeedsAttention") },
      { value: "active", label: t("projectsFilterActive") },
    ],
    [t],
  );

  const ageOptions: FilterOption<ProjectAgeFilter>[] = useMemo(
    () => [
      { value: "1", label: t("projectsFilterAge1Day") },
      { value: "7", label: t("projectsFilterAge7Days") },
      { value: "30", label: t("projectsFilterAge30Days") },
    ],
    [t],
  );

  const hasFilters =
    searchInput.trim() !== "" ||
    statusFilter.length > 0 ||
    ageFilter.length > 0;

  const clearFilters = () => {
    setSearchInput("");
    setStatusFilter([]);
    setAgeFilter([]);
  };

  // Core "add this path as a project" flow. Reused by both the manual form
  // submit and the native folder picker (which auto-submits the picked path).
  const submitAddProject = async (rawPath: string) => {
    const path = rawPath.trim();
    if (!path) return;

    setAdding(true);
    setAddError(null);

    try {
      const { project } = await api.addProject(path);
      await refetch();
      setNewProjectPath("");
      setShowAddForm(false);
      // Navigate to sessions filtered by the new project
      navigate(`${basePath}/sessions?project=${project.id}`);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t("projectsAddFailed"));
    } finally {
      setAdding(false);
    }
  };

  const handleAddProject = (e: React.FormEvent) => {
    e.preventDefault();
    void submitAddProject(newProjectPath);
  };

  // Server-side folder picker. Opens a modal that browses the filesystem of
  // the machine running the Yep Anywhere server, so it works from any client
  // (desktop browser, phone, tablet) and selects a directory on the *server*
  // device. The chosen path goes through the identical server pipeline as a
  // hand-typed one (POST /api/projects -> canonicalize -> stat -> cwd).
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const handleBrowseFolder = () => {
    if (adding) return;
    setShowFolderBrowser(true);
  };

  // NOTE: we intentionally do NOT early-return on `loading`. Returning a bare
  // "Loading..." here makes the whole page (header, filter bar, sidebar
  // toggle) blink out and pop back in once data arrives. Instead we always
  // render the chrome and only swap the list content for a skeleton.
  if (error) {
    return (
      <div className="error">
        {t("projectsErrorPrefix")} {error.message}
      </div>
    );
  }

  const isEmpty = !loading && projects.length === 0;

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
          title={t("pageTitleProjects")}
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            {/* Filter bar (matches GlobalSessionsPage layout) */}
            <div className="filter-bar">
              <form
                onSubmit={(e) => e.preventDefault()}
                className="filter-search-form"
              >
                <input
                  type="text"
                  className="filter-search"
                  placeholder={t("projectsSearchPlaceholder")}
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
                <button
                  type="submit"
                  className="filter-search-button"
                  aria-label={t("projectsSearchPlaceholder")}
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
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </button>
              </form>
              <div className="filter-dropdowns">
                <FilterDropdown
                  label={t("projectsFilterStatus")}
                  options={statusOptions}
                  selected={statusFilter}
                  onChange={setStatusFilter}
                  placeholder={t("projectsFilterStatusPlaceholder")}
                />
                <FilterDropdown
                  label={t("projectsFilterAge")}
                  options={ageOptions}
                  selected={ageFilter}
                  onChange={setAgeFilter}
                  multiSelect={false}
                  placeholder={t("projectsFilterAgePlaceholder")}
                />
                {!showAddForm ? (
                  <button
                    type="button"
                    className="filter-clear-button"
                    onClick={() => setShowAddForm(true)}
                    aria-label={t("projectsAdd")}
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
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    {t("projectsAdd")}
                  </button>
                ) : null}
              </div>
              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="filter-clear-button"
                >
                  {t("projectsClearFilters")}
                </button>
              )}
            </div>

            {/* Add-project form (only shown when toggled) */}
            {showAddForm && (
              <div className="inbox-toolbar">
                <form onSubmit={handleAddProject} className="add-project-form">
                  <div className="add-project-input-row">
                    <input
                      type="text"
                      value={newProjectPath}
                      onChange={(e) => setNewProjectPath(e.target.value)}
                      placeholder={t("projectsAddPlaceholder")}
                      disabled={adding}
                    />
                    <button
                      type="button"
                      className="add-project-browse"
                      onClick={handleBrowseFolder}
                      disabled={adding}
                      aria-label={t("projectsBrowse")}
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
                        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                      </svg>
                      {t("projectsBrowse")}
                    </button>
                  </div>
                  <div className="add-project-actions">
                    <button
                      type="submit"
                      disabled={adding || !newProjectPath.trim()}
                    >
                      {adding ? t("projectsAdding") : t("projectsAddConfirm")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddForm(false);
                        setNewProjectPath("");
                        setAddError(null);
                      }}
                      disabled={adding}
                    >
                      {t("projectsCancel")}
                    </button>
                  </div>
                  {addError && (
                    <div className="add-project-error">{addError}</div>
                  )}
                </form>
              </div>
            )}

            {showFolderBrowser && (
              <FolderBrowserModal
                onClose={() => setShowFolderBrowser(false)}
                onSelect={(absolutePath) => {
                  setShowFolderBrowser(false);
                  void submitAddProject(absolutePath);
                }}
              />
            )}

            {loading ? (
              <ProjectListSkeleton />
            ) : isEmpty ? (
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
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <h3>{t("projectsEmptyTitle")}</h3>
                <p>{t("projectsEmptyDescription")}</p>
              </div>
            ) : (
              <ul className="project-list-cards content-fade-in">
                {filteredProjects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    needsAttentionCount={
                      attentionByProject.get(project.id) ?? 0
                    }
                    thinkingCount={thinkingByProject.get(project.id) ?? 0}
                    basePath={basePath}
                  />
                ))}
              </ul>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
