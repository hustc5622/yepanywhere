import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { fetchJSON } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import "../styles/dsh.css";

let pendingLaunch: Promise<{ url: string }> | undefined;
function launchDsh() {
  pendingLaunch ??= fetchJSON<{ url: string }>("/dsh/launch", {
    method: "POST",
  }).finally(() => {
    pendingLaunch = undefined;
  });
  return pendingLaunch;
}

/**
 * dsh Web persists its main selection in this localStorage key and restores
 * it when the app boots (references/dsh/packages/client/ui-workspace/src/
 * client/navigation.ts). The proxied page shares Yep's origin, so writing it
 * before the iframe loads opens that session in the native UI.
 */
const DSH_SELECTION_STORAGE_KEY = "dsh.sessions.current";

function preselectDshSession(sessionId: string): void {
  try {
    localStorage.setItem(
      DSH_SELECTION_STORAGE_KEY,
      JSON.stringify({ sessionId }),
    );
  } catch {
    // Storage may be unavailable (private mode); dsh opens its default view.
  }
}

export function DshPage() {
  const [searchParams] = useSearchParams();
  const requestedSessionId = searchParams.get("session") ?? undefined;
  const { t } = useI18n();
  const { openSidebar, isWideScreen } = useNavigationLayout();
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed launch; a new session request reloads the frame.
  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    setUrl(undefined);
    launchDsh()
      .then(({ url }) => {
        if (cancelled) return;
        if (requestedSessionId) preselectDshSession(requestedSessionId);
        setUrl(url);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setError(error instanceof Error ? error.message : "DSH_START_FAILED");
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, requestedSessionId]);

  return (
    <div className="main-content-wrapper dsh-page">
      {!isWideScreen && (
        <PageHeader
          title=""
          onOpenSidebar={openSidebar}
          isWideScreen={isWideScreen}
        />
      )}
      {url ? (
        <iframe
          key={`${attempt}:${requestedSessionId ?? ""}`}
          className="dsh-frame"
          src={url}
          title={t("sidebarDsh")}
          allow="clipboard-read; clipboard-write"
        />
      ) : (
        <div className="dsh-status" role={error ? "alert" : "status"}>
          <p>
            {error
              ? error === "DSH_NOT_INSTALLED"
                ? t("dshNotInstalled")
                : t("dshStartFailed")
              : t("dshStarting")}
          </p>
          {error === "DSH_NOT_INSTALLED" && (
            <code>npm install -g @deepseek-ai/dsh@next</code>
          )}
          {error && (
            <button type="button" onClick={retry}>
              {t("dshRetry")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
