import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { FileEditor } from "../components/FileEditor";
import { useI18n } from "../i18n";

/**
 * FilePage - Standalone page for viewing/editing files.
 * Route: /projects/:projectId/file?path=<path>
 *
 * Renders the same FileEditor used by the in-app tab, so the standalone
 * page is identical in behaviour and appearance:
 *   - .md  → Tiptap WYSIWYG (consistent with the tab)
 *   - any other text file → FileViewer preview + textarea edit
 * The editor's own close button navigates back to the project.
 */
export function FilePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const filePath = searchParams.get("path");

  if (!projectId) {
    return (
      <div className="file-page file-page-error">
        <div className="file-page-error-content">
          <h1>{t("fileInvalidUrl" as never)}</h1>
          <p>{t("fileMissingProjectId" as never)}</p>
          <Link to="/projects" className="file-page-back-link">
            {t("fileGoToProjects" as never)}
          </Link>
        </div>
      </div>
    );
  }

  if (!filePath) {
    return (
      <div className="file-page file-page-error">
        <div className="file-page-error-content">
          <h1>{t("fileInvalidUrl" as never)}</h1>
          <p>{t("fileMissingPath" as never)}</p>
          <Link to={`/projects/${projectId}`} className="file-page-back-link">
            {t("fileGoToProject" as never)}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="file-page">
      <FileEditor
        projectId={projectId}
        filePath={filePath}
        onClose={() => navigate(`/projects/${projectId}`)}
        onDirtyChange={() => {}}
      />
    </div>
  );
}
