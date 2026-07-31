import { useSearchParams } from "react-router-dom";
import { NewSessionForm } from "../components/NewSessionForm";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { CardListSkeleton } from "../components/Skeleton";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useProject, useProjects } from "../hooks/useProjects";
import {
  getRecentProjectId,
  resolvePreferredProjectId,
} from "../hooks/useRecentProject";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";

export function NewSessionPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  // Get all projects to find default if no projectId specified
  const { projects, loading: projectsLoading } = useProjects();

  // The recent project is already known locally, so don't hold the form behind
  // the full project-list request. Once that request resolves it still
  // validates the recent id and falls back to the first available project.
  const recentProjectId = getRecentProjectId();
  const effectiveProjectId =
    projectId ||
    (projectsLoading
      ? recentProjectId
      : resolvePreferredProjectId(projects, recentProjectId));

  const listedProject = projects.find(
    (candidate) => candidate.id === effectiveProjectId,
  );

  const { project: fetchedProject, error } = useProject(
    listedProject ? undefined : (effectiveProjectId ?? undefined),
  );
  const project = listedProject ?? fetchedProject;

  // Update browser tab title (must be called unconditionally before any early returns)
  useDocumentTitle(project?.name, t("newSessionTitle"));

  // Callback to update projectId in URL without navigation
  const handleProjectChange = (newProjectId: string) => {
    setSearchParams({ projectId: newProjectId }, { replace: true });
  };

  // A known project id is enough to render and use the form. Project metadata
  // only decorates the header and can arrive in the background.
  const loading = !effectiveProjectId && projectsLoading;
  const projectError = !projectsLoading && !listedProject ? error : null;

  // Guard against missing projectId (no projects available)
  if (!effectiveProjectId && !projectsLoading && projects.length === 0) {
    return <div className="error">{t("newSessionNoProjects")}</div>;
  }

  // Render loading/error states
  if (loading || projectError) {
    return (
      <div
        className={
          isWideScreen ? "main-content-wrapper" : "main-content-mobile"
        }
      >
        <div
          className={
            isWideScreen
              ? "main-content-constrained"
              : "main-content-mobile-inner"
          }
        >
          <PageHeader
            title={t("newSessionTitle")}
            onOpenSidebar={openSidebar}
            onToggleSidebar={toggleSidebar}
            isWideScreen={isWideScreen}
            isSidebarCollapsed={isSidebarCollapsed}
          />
          <main className="page-scroll-container">
            <div className="page-content-inner">
              {loading ? (
                <CardListSkeleton count={2} height={120} />
              ) : (
                <div className="error">
                  {t("newSessionErrorPrefix")} {error?.message}
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    );
  }

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
          title={project?.name ?? t("newSessionTitle")}
          titleElement={
            effectiveProjectId ? (
              <ProjectSelector
                currentProjectId={effectiveProjectId}
                currentProjectName={project?.name}
                projects={projects}
                projectsLoading={projectsLoading}
                onProjectChange={(p) => handleProjectChange(p.id)}
              />
            ) : undefined
          }
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            {effectiveProjectId && (
              <NewSessionForm projectId={effectiveProjectId} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
