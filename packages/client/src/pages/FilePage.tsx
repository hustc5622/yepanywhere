import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { FileViewer } from "../components/FileViewer";
import { useI18n } from "../i18n";
import { type FileRef, filePageRoute } from "../lib/fileRef";

/**
 * FilePage - Standalone page for viewing files.
 * Routes:
 *   /file?path=<absolute or relative>&projectId=<id>&line=<n>
 *   /projects/:projectId/file?path=<relative>   (legacy links)
 */
export function FilePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const params = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const filePath = searchParams.get("path");
  const projectId =
    params.projectId ?? searchParams.get("projectId") ?? undefined;
  const line = Number.parseInt(searchParams.get("line") ?? "", 10);
  const backTo = projectId ? `/projects/${projectId}` : "/projects";
  const backLabel = projectId
    ? t("fileBackToProject" as never)
    : t("fileGoToProjects" as never);

  if (!filePath) {
    return (
      <div className="file-page file-page-error">
        <div className="file-page-error-content">
          <h1>{t("fileInvalidUrl" as never)}</h1>
          <p>{t("fileMissingPath" as never)}</p>
          <Link to={backTo} className="file-page-back-link">
            {backLabel}
          </Link>
        </div>
      </div>
    );
  }

  const fileRef: FileRef = {
    path: filePath,
    ...(projectId && { projectId }),
    ...(Number.isFinite(line) && { lineNumber: line }),
  };

  return (
    <div className="file-page">
      <div className="file-page-nav">
        <Link to={backTo} className="file-page-back-link" title={backLabel}>
          <BackIcon />
          <span>{backLabel}</span>
        </Link>
      </div>
      <div className="file-page-content">
        <FileViewer
          fileRef={fileRef}
          standalone
          onNavigate={(next) => navigate(filePageRoute(next))}
        />
      </div>
    </div>
  );
}

function BackIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 12L6 8l4-4" />
    </svg>
  );
}
