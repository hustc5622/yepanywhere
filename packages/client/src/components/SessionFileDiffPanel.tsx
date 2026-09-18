import type { SessionFileDiff } from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { DetailPanel } from "./ui/DetailPanel";

interface Props {
  projectId: string;
  sessionId: string;
  filePath: string;
  onClose: () => void;
  /** Switch to the plain file viewer for the same path. */
  onOpenFile: () => void;
}

/**
 * Diff of one file between the session's baseline commit and the worktree.
 *
 * This answers "what did this session do to this file?", which a plain file
 * viewer cannot: the worktree only shows the end state.
 */
export function SessionFileDiffPanel({
  projectId,
  sessionId,
  filePath,
  onClose,
  onOpenFile,
}: Props) {
  const { t } = useI18n();
  const [diff, setDiff] = useState<SessionFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fullContext, setFullContext] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .getSessionFileDiff(projectId, sessionId, {
        path: filePath,
        fullContext,
        signal: controller.signal,
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        setDiff(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [filePath, fullContext, projectId, sessionId]);

  return (
    <DetailPanel title={filePath} ariaLabel={filePath} onClose={onClose}>
      <div className="session-file-diff">
        <div className="session-file-diff-toolbar">
          <button
            type="button"
            className="session-file-diff-action"
            onClick={onOpenFile}
          >
            {t("sessionFileDiffOpenFile")}
          </button>
          <button
            type="button"
            className="session-file-diff-action"
            onClick={() => setFullContext((prev) => !prev)}
          >
            {t(fullContext ? "gitStatusDiffOnly" : "gitStatusFullContext")}
          </button>
          {diff && !diff.exact ? (
            <span
              className="session-file-diff-base"
              title={t("sessionFileDiffPartialHint")}
            >
              {t("sessionFileDiffPartial")}
            </span>
          ) : null}
        </div>
        {loading ? (
          <div className="session-inspector-empty">{t("gitStatusLoading")}</div>
        ) : error ? (
          <div className="session-inspector-empty">
            {t("sessionFileDiffUnavailable")}
          </div>
        ) : diff?.diffHtml ? (
          <div
            className="highlighted-diff"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output rendered server-side
            dangerouslySetInnerHTML={{ __html: diff.diffHtml }}
          />
        ) : (
          <div className="session-inspector-empty">
            {t("sessionFileDiffEmpty")}
          </div>
        )}
      </div>
    </DetailPanel>
  );
}
