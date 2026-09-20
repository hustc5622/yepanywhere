import type {
  SessionFileActivity,
  SessionFileDiff,
  SessionSavedFileContent,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { DetailPanel } from "./ui/DetailPanel";
import "../styles/session-saved-file.css";

export function SessionSavedFilePanel({
  projectId,
  sessionId,
  branchId,
  file,
  onClose,
  onOpenCurrent,
}: {
  projectId: string;
  sessionId: string;
  branchId?: string;
  file: SessionFileActivity;
  onClose: () => void;
  onOpenCurrent: () => void;
}) {
  const { t } = useI18n();
  const [chosenId, setSelectedId] = useState(
    file.savedVersions?.[0]?.recordId ?? "",
  );
  const selectedId = file.savedVersions?.some(
    (version) => version.recordId === chosenId,
  )
    ? chosenId
    : (file.savedVersions?.[0]?.recordId ?? "");
  const [mode, setMode] = useState<"content" | "diff">("content");
  const [data, setData] = useState<SessionSavedFileContent | null>(null);
  const [diff, setDiff] = useState<SessionFileDiff | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    setData(null);
    setDiff(null);
    const options = {
      path: file.path,
      recordId: selectedId,
      branchId,
      signal: controller.signal,
    };
    const fetch = async () => {
      try {
        if (mode === "content") {
          const content = await api.getSessionSavedFile(
            projectId,
            sessionId,
            options,
          );
          if (!controller.signal.aborted) setData(content);
        } else {
          const result = await api.getSessionFileDiff(
            projectId,
            sessionId,
            options,
          );
          if (!controller.signal.aborted) setDiff(result);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void fetch();
    return () => controller.abort();
  }, [projectId, sessionId, branchId, file.path, selectedId, mode]);
  const partial =
    file.savedVersions?.find((version) => version.recordId === selectedId)
      ?.complete === false;
  return (
    <DetailPanel title={file.path} ariaLabel={file.path} onClose={onClose}>
      <div className="session-file-diff-toolbar">
        <select
          aria-label={t("sessionSavedVersion")}
          value={selectedId}
          onChange={(event) => setSelectedId(event.target.value)}
        >
          {file.savedVersions?.map((version) => (
            <option key={version.recordId} value={version.recordId}>
              {new Date(version.timestamp).toLocaleString()} ·{" "}
              {t(
                version.kind === "added"
                  ? "sessionSavedAdded"
                  : version.kind === "deleted"
                    ? "sessionSavedDeleted"
                    : "sessionSavedModified",
              )}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="session-file-diff-action"
          aria-pressed={mode === "content"}
          onClick={() => setMode("content")}
        >
          {t("sessionSavedVersion")}
        </button>
        <button
          type="button"
          className="session-file-diff-action"
          aria-pressed={mode === "diff"}
          onClick={() => setMode("diff")}
        >
          {t("sessionSavedDiff")}
        </button>
        <button
          type="button"
          className="session-file-diff-action"
          onClick={onOpenCurrent}
        >
          {t("sessionSavedCurrent")}
        </button>
      </div>
      <p className="session-saved-note">
        {t("sessionSavedObserved")}
        {partial ? ` · ${t("sessionSavedPartial")}` : ""}
      </p>
      {loading ? (
        <div role="status">{t("gitStatusLoading")}</div>
      ) : error ? (
        <div role="alert">{t("sessionSavedUnavailable")}</div>
      ) : mode === "diff" ? (
        diff?.diffHtml ? (
          <div
            className="highlighted-diff"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized server-side diff renderer
            dangerouslySetInnerHTML={{ __html: diff.diffHtml }}
          />
        ) : (
          <p>{t("sessionFileDiffEmpty")}</p>
        )
      ) : data ? (
        <>
          {data.deleted ? <p>{t("sessionSavedDeletedPreview")}</p> : null}
          {data.binary ? (
            <p>{t("sessionSavedBinary")}</p>
          ) : data.renderedMarkdownHtml ? (
            <div
              className="markdown-content"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: server uses the existing safe markdown renderer
              dangerouslySetInnerHTML={{ __html: data.renderedMarkdownHtml }}
            />
          ) : (
            <pre className="session-saved-source">{data.content}</pre>
          )}
        </>
      ) : null}
    </DetailPanel>
  );
}
