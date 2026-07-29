import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { type ApiError, api } from "../api/client";
import { useI18n } from "../i18n";

type LocateState =
  | { status: "resolving" }
  | { status: "resolved"; projectId: string; sessionId: string }
  | { status: "not-found" }
  | { status: "failed"; message: string };

/**
 * SessionLocatorPage - makes a bare session id addressable.
 * Route: /sessions/:sessionId
 *
 * Session pages live at `/projects/:projectId/sessions/:sessionId`, but the ids
 * users hold carry no project. This page resolves the id server-side and
 * replaces itself with the canonical URL, so a pasted id just works.
 */
export function SessionLocatorPage() {
  const { t } = useI18n();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [state, setState] = useState<LocateState>({ status: "resolving" });

  useEffect(() => {
    if (!sessionId) {
      setState({ status: "not-found" });
      return;
    }

    let cancelled = false;
    setState({ status: "resolving" });

    api
      .locateSession(sessionId)
      .then((response) => {
        if (cancelled) return;
        setState({
          status: "resolved",
          projectId: response.session.projectId,
          // Follow the canonical id so alias redirects land on the real session.
          sessionId: response.session.sessionId,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // A 404 is the expected "no provider claims this id" answer; anything
        // else is a real failure worth showing verbatim.
        const status = (error as Partial<ApiError> | null)?.status;
        if (status === 404) {
          setState({ status: "not-found" });
          return;
        }
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (state.status === "resolved") {
    return (
      <Navigate
        to={`/projects/${state.projectId}/sessions/${state.sessionId}`}
        replace
      />
    );
  }

  if (state.status === "resolving") {
    return (
      <div className="file-page file-page-error">
        <div className="file-page-error-content">
          <h1>{t("sessionLocateResolving")}</h1>
          <p>
            <code>{sessionId}</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="file-page file-page-error">
      <div className="file-page-error-content">
        <h1>
          {state.status === "not-found"
            ? t("sessionLocateNotFound")
            : t("sessionLocateFailed")}
        </h1>
        <p>
          {state.status === "not-found" ? (
            <code>{sessionId}</code>
          ) : (
            state.message
          )}
        </p>
        <Link to="/sessions" className="file-page-back-link">
          {t("sessionLocateBackToSessions")}
        </Link>
      </div>
    </div>
  );
}
